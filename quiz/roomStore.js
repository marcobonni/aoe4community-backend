function createRoomStore() {
  const rooms = {};

  return {
    rooms,

    has(code) {
      return Boolean(rooms[code]);
    },

    get(code) {
      return rooms[code] || null;
    },

    set(code, room) {
      rooms[code] = room;
      return room;
    },

    remove(code) {
      delete rooms[code];
    },

    getAll() {
      return Object.values(rooms);
    },

    clear() {
      Object.keys(rooms).forEach((code) => {
        delete rooms[code];
      });
    },
  };
}

module.exports = {
  createRoomStore,
};