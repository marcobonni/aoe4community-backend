function getRemainingQuestionTime(room, question) {
  if (!room || !question || !room.roundStartedAt) {
    return question?.durationMs ?? 0;
  }

  const pausedExtra =
    room.isPaused && room.pausedAt
      ? Date.now() - room.pausedAt
      : 0;

  const elapsed =
    Date.now() -
    room.roundStartedAt -
    (room.pauseAccumulatedMs || 0) -
    pausedExtra;

  return Math.max(0, question.durationMs - elapsed);
}

function getRemainingRevealTime(room, REVEAL_DURATION_MS) {
  if (!room || !room.revealStartedAt) {
    return REVEAL_DURATION_MS;
  }

  const pausedExtra =
    room.isPaused && room.pausedAt
      ? Date.now() - room.pausedAt
      : 0;

  const elapsed =
    Date.now() -
    room.revealStartedAt -
    (room.pauseAccumulatedMs || 0) -
    pausedExtra;

  return Math.max(0, REVEAL_DURATION_MS - elapsed);
}

module.exports = {
  getRemainingQuestionTime,
  getRemainingRevealTime,
};