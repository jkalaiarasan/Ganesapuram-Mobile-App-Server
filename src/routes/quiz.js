const express = require('express');
const router = express.Router();
const {
  sfQuery, soqlEscape, sfCreateRecord, sfUpdateRecord, sfInsertMany,
} = require('../services/salesforce');

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(id);
}

// Questions are rich text: bilingual Tamil/English wrapped in <p> tags. Turn the
// paragraph breaks into newlines, then drop the remaining markup.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\/p>\s*<p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// Stored newline-separated, but with CRLF. Splitting on \n alone (as the Apex
// does) leaves a trailing \r on every option, so answers never match.
function parseOptions(raw) {
  if (!raw) return [];
  const parts = String(raw).includes(';') && !String(raw).includes('\n')
    ? String(raw).split(';')
    : String(raw).split(/\r?\n/);
  return parts.map(o => o.trim()).filter(Boolean);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// POST /api/quiz/login — { userId, loginCode }
router.post('/login', async (req, res) => {
  const { userId, loginCode } = req.body;
  if (!userId || !loginCode) {
    return res.status(400).json({ success: false, message: 'userId and loginCode are required' });
  }

  try {
    const rows = await sfQuery(
      `SELECT Id, Name, UserId__c, IsSubmitted__c, IsApproved__c, Score__c, WarningCount__c,
              Quiz__c, Quiz__r.Name, Quiz__r.Duration__c, Quiz__r.AllowLogin__c, Quiz__r.ResultPublished__c
       FROM QuizMember__c WHERE LoginCode__c = '${soqlEscape(loginCode)}'`
    );

    // Match the username case-insensitively, as the Apex does.
    const member = rows.find(
      m => m.UserId__c && m.UserId__c.toLowerCase() === String(userId).toLowerCase()
    );
    if (!member) {
      return res.status(401).json({ success: false, message: 'Invalid username or login code' });
    }
    if (member.Quiz__r?.AllowLogin__c === false) {
      return res.status(403).json({ success: false, message: 'This quiz is not open right now' });
    }

    res.json({
      success: true,
      member: {
        id: member.Id,
        name: member.Name,
        userId: member.UserId__c,
        isSubmitted: !!member.IsSubmitted__c,
        score: member.Score__c ?? null,
        warningCount: member.WarningCount__c ?? 0,
      },
      quiz: {
        id: member.Quiz__c,
        name: member.Quiz__r?.Name ?? null,
        duration: member.Quiz__r?.Duration__c ?? null,
        resultPublished: !!member.Quiz__r?.ResultPublished__c,
      },
    });
  } catch (err) {
    console.error('quiz login error:', err.message);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// POST /api/quiz/register — { name, email }
// Insert only. QuizMemberTrigger assigns the quiz and a zero score before
// insert, then notifies the admin on Telegram and emails the registrant, so a
// login code is issued only once an admin approves.
router.post('/register', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'name and email are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address' });
  }

  try {
    const existing = await sfQuery(
      `SELECT Id, IsApproved__c FROM QuizMember__c
       WHERE Email__c = '${soqlEscape(email)}' LIMIT 1`
    );
    if (existing.length) {
      return res.status(409).json({
        success: false,
        message: existing[0].IsApproved__c
          ? 'This email is already registered and approved'
          : 'This email is already registered and awaiting approval',
      });
    }

    // One record per call: QuizMemberTrigger only ever handles Trigger.new[0],
    // so a batched insert would silently skip everyone after the first.
    const id = await sfCreateRecord('QuizMember__c', {
      Name: String(name).slice(0, 80),
      Email__c: email,
    });

    res.json({
      success: true,
      id,
      message: 'Registration received. You will get your login code once an admin approves.',
    });
  } catch (err) {
    console.error('quiz register error:', err.response?.data ?? err.message);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// GET /api/quiz/:quizId/results — leaderboard, published quizzes only.
// Mirrors QuizController.getQuizMembersWithScores.
router.get('/:quizId/results', async (req, res) => {
  const { quizId } = req.params;
  if (!validId(quizId)) return res.status(400).json({ success: false, message: 'Invalid quiz id' });

  try {
    const rows = await sfQuery(
      `SELECT Id, Name, UserId__c, Score__c, FinalScore__c, WarningCount__c, Quiz__r.Name
       FROM QuizMember__c
       WHERE Quiz__c = '${quizId}' AND Quiz__r.ResultPublished__c = true
       ORDER BY FinalScore__c DESC NULLS LAST, Score__c DESC NULLS LAST`
    );

    if (!rows.length) {
      return res.json({ success: true, published: false, quizName: null, results: [] });
    }

    res.json({
      success: true,
      published: true,
      quizName: rows[0].Quiz__r?.Name ?? null,
      results: rows.map((m, i) => ({
        rank: i + 1,
        id: m.Id,
        name: m.Name,
        userId: m.UserId__c ?? null,
        score: m.Score__c ?? 0,
        finalScore: m.FinalScore__c ?? null,
        warningCount: m.WarningCount__c ?? 0,
      })),
    });
  } catch (err) {
    console.error('quiz results error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load results' });
  }
});

// GET /api/quiz/:quizId/questions — shuffled, correct answers withheld.
router.get('/:quizId/questions', async (req, res) => {
  const { quizId } = req.params;
  if (!validId(quizId)) return res.status(400).json({ success: false, message: 'Invalid quiz id' });

  try {
    const rows = await sfQuery(
      `SELECT Id, Name, Question__c, Options__c FROM QuizQuestion__c
       WHERE Quiz__c = '${quizId}' ORDER BY Name ASC`
    );

    const questions = shuffle(rows).map((q, i) => ({
      id: q.Id,
      number: i + 1,
      question: htmlToText(q.Question__c),
      options: parseOptions(q.Options__c),
    }));

    res.json({ success: true, total: questions.length, questions });
  } catch (err) {
    console.error('quiz questions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load questions' });
  }
});

// POST /api/quiz/submit — { memberId, answers: {questionId: answer}, warningCount }
// Scoring happens here, never on the device: the correct answers are not sent
// to the client at any point before submission.
router.post('/submit', async (req, res) => {
  const { memberId, answers, warningCount } = req.body;
  if (!validId(memberId) || typeof answers !== 'object' || answers === null) {
    return res.status(400).json({ success: false, message: 'memberId and answers are required' });
  }

  try {
    const members = await sfQuery(
      `SELECT Id, Quiz__c, IsSubmitted__c FROM QuizMember__c WHERE Id = '${memberId}' LIMIT 1`
    );
    if (!members.length) return res.status(404).json({ success: false, message: 'Member not found' });
    if (members[0].IsSubmitted__c) {
      return res.status(409).json({ success: false, message: 'This quiz has already been submitted' });
    }

    const questions = await sfQuery(
      `SELECT Id, Answer__c FROM QuizQuestion__c WHERE Quiz__c = '${members[0].Quiz__c}'`
    );
    const correct = {};
    for (const q of questions) correct[q.Id] = (q.Answer__c ?? '').trim().toLowerCase();

    let score = 0;
    const rows = [];
    for (const [questionId, given] of Object.entries(answers)) {
      if (!validId(questionId) || !(questionId in correct)) continue;
      const value = given == null ? '' : String(given);
      rows.push({ QuizMember__c: memberId, QuizQuestion__c: questionId, Answer__c: value });
      if (value.trim().toLowerCase() === correct[questionId] && correct[questionId] !== '') score++;
    }

    await sfInsertMany('QuizAnswer__c', rows);
    await sfUpdateRecord('QuizMember__c', memberId, {
      Score__c: score,
      WarningCount__c: Number(warningCount) || 0,
      IsSubmitted__c: true,
    });

    res.json({ success: true, score, total: questions.length, attempted: rows.length });
  } catch (err) {
    console.error('quiz submit error:', err.response?.data ?? err.message);
    res.status(500).json({ success: false, message: 'Failed to submit quiz' });
  }
});

// POST /api/quiz/warning — { memberId } — records a tab-switch while in progress
// so a disconnect mid-quiz does not lose the count.
router.post('/warning', async (req, res) => {
  const { memberId } = req.body;
  if (!validId(memberId)) return res.status(400).json({ success: false, message: 'Invalid member id' });

  try {
    const rows = await sfQuery(
      `SELECT Id, WarningCount__c FROM QuizMember__c WHERE Id = '${memberId}' LIMIT 1`
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Member not found' });

    const next = (rows[0].WarningCount__c ?? 0) + 1;
    await sfUpdateRecord('QuizMember__c', memberId, { WarningCount__c: next });
    res.json({ success: true, warningCount: next });
  } catch (err) {
    console.error('quiz warning error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record warning' });
  }
});

// GET /api/quiz/answersheet/:memberId — only once submitted and published.
router.get('/answersheet/:memberId', async (req, res) => {
  const { memberId } = req.params;
  if (!validId(memberId)) return res.status(400).json({ success: false, message: 'Invalid member id' });

  try {
    const members = await sfQuery(
      `SELECT Id, Name, UserId__c, Score__c, FinalScore__c, WarningCount__c, IsSubmitted__c,
              Quiz__c, Quiz__r.Name, Quiz__r.ResultPublished__c
       FROM QuizMember__c WHERE Id = '${memberId}' LIMIT 1`
    );
    if (!members.length) return res.status(404).json({ success: false, message: 'Member not found' });

    const m = members[0];
    if (!m.IsSubmitted__c) {
      return res.status(409).json({ success: false, message: 'Quiz not submitted yet' });
    }
    if (!m.Quiz__r?.ResultPublished__c) {
      return res.status(403).json({ success: false, message: 'Results are not published yet' });
    }

    const [given, questions] = await Promise.all([
      sfQuery(`SELECT QuizQuestion__c, Answer__c FROM QuizAnswer__c WHERE QuizMember__c = '${memberId}'`),
      sfQuery(
        `SELECT Id, Name, Question__c, Options__c, Answer__c FROM QuizQuestion__c
         WHERE Quiz__c = '${m.Quiz__c}' ORDER BY Name ASC`
      ),
    ]);

    const byQuestion = {};
    for (const a of given) byQuestion[a.QuizQuestion__c] = (a.Answer__c ?? '').trim();

    res.json({
      success: true,
      attendee: {
        name: m.Name,
        userId: m.UserId__c,
        score: m.Score__c ?? 0,
        finalScore: m.FinalScore__c ?? null,
        warningCount: m.WarningCount__c ?? 0,
        quizName: m.Quiz__r?.Name ?? null,
      },
      sheet: questions.map((q, i) => {
        const selected = byQuestion[q.Id] ?? '';
        const answer = (q.Answer__c ?? '').trim();
        return {
          id: q.Id,
          number: i + 1,
          question: htmlToText(q.Question__c),
          options: parseOptions(q.Options__c),
          selectedAnswer: selected,
          correctAnswer: answer,
          isCorrect: selected !== '' && selected.toLowerCase() === answer.toLowerCase(),
        };
      }),
    });
  } catch (err) {
    console.error('quiz answersheet error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load answer sheet' });
  }
});

module.exports = router;
