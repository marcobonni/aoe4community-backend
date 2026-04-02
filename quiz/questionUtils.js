function shuffleArray(items) {
  const cloned = [...items];

  for (let i = cloned.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }

  return cloned;
}

function shuffleQuestionOptions(question) {
  const optionsWithIndex = question.options.map((option, index) => ({
    option,
    originalIndex: index,
  }));

  const shuffled = shuffleArray(optionsWithIndex);

  const correctIndex = shuffled.findIndex(
    (e) => e.originalIndex === question.correctIndex
  );

  return {
    ...question,
    options: shuffled.map((e) => e.option),
    correctIndex,
  };
}

function buildQuestionPool(room, QUESTIONS, QUESTION_CATEGORIES) {
  const selected =
    room.settings?.categories?.length > 0
      ? room.settings.categories
      : QUESTION_CATEGORIES.map((c) => c.id);

  const filtered = QUESTIONS.filter((q) =>
    selected.includes(q.category)
  );

  const shuffled = shuffleArray(filtered).map(shuffleQuestionOptions);

  const count = Math.min(room.settings.totalQuestions, shuffled.length);

  return shuffled.slice(0, count);
}

function getCurrentQuestion(room) {
  return room.gameQuestions[room.currentQuestionIndex] || null;
}

function getDifficultyMultiplier(difficulty, DIFFICULTY_MULTIPLIERS) {
  return DIFFICULTY_MULTIPLIERS[difficulty] ?? 1;
}

module.exports = {
  shuffleArray,
  shuffleQuestionOptions,
  buildQuestionPool,
  getCurrentQuestion,
  getDifficultyMultiplier,
};