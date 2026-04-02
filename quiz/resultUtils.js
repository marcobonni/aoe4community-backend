const { sortPlayers } = require("./roomUtils");

function getAnswerMarkers(room) {
  return Object.entries(room.currentAnswers || {}).map(
    ([playerId, answerIndex]) => {
      const player = room.players.find((p) => p.id === playerId);

      return {
        playerId,
        playerName: player?.name ?? "Giocatore",
        answerIndex,
      };
    }
  );
}

function getRoundResults(room) {
  return Object.values(room.currentRoundResults || {}).sort(
    (a, b) => b.totalScore - a.totalScore
  );
}

function getFinalResults(room) {
  return sortPlayers(room.players).map((player) => {
    const stats = room.playerStats[player.id] || {
      correctAnswers: 0,
      wrongAnswers: 0,
      answeredQuestions: 0,
      totalPointsEarned: 0,
      totalResponseTimeMs: 0,
      rounds: [],
    };

    const avgResponseTimeMs =
      stats.answeredQuestions > 0
        ? Math.round(
            stats.totalResponseTimeMs / stats.answeredQuestions
          )
        : 0;

    return {
      playerId: player.id,
      playerName: player.name,
      finalScore: player.score,
      correctAnswers: stats.correctAnswers,
      wrongAnswers: stats.wrongAnswers,
      answeredQuestions: stats.answeredQuestions,
      accuracy:
        stats.answeredQuestions > 0
          ? Math.round(
              (stats.correctAnswers / stats.answeredQuestions) * 100
            )
          : 0,
      totalPointsEarned: stats.totalPointsEarned,
      avgResponseTimeMs,
      rounds: stats.rounds,
    };
  });
}

module.exports = {
  getAnswerMarkers,
  getRoundResults,
  getFinalResults,
};