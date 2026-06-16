const assert = require('node:assert/strict');
const test = require('node:test');
const { createProgressReporter } = require('../scripts/zhihu-archive');

test('progress reporter prints timestamped unique progress only once', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    const report = createProgressReporter();
    report({ answerCount: 5, totalAnswerCount: 504, expandComments: true, idleRounds: 0 });
    report({ answerCount: 5, totalAnswerCount: 504, expandComments: true, idleRounds: 0 });
    report({ answerCount: 10, totalAnswerCount: 504, expandComments: true, idleRounds: 0 });
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\] Progress: 5\/504$/);
  assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\] Progress: 10\/504$/);
});

test('progress reporter shows idle rounds only when greater than zero', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    const report = createProgressReporter();
    report({ answerCount: 5, totalAnswerCount: 504, expandComments: true, idleRounds: 1 });
  } finally {
    console.log = originalLog;
  }

  assert.match(lines[0], /idle rounds: 1$/);
});
