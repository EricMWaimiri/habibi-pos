// Optional notifications only; details must use the authorized sale HTTP API.
function emitDocket(io, event, payload) {
  if (!io) return;
  if (io.posSecurity) void io.posSecurity.publish(`docket:${event}`, payload).catch(() => {});
}

module.exports = { emitDocket };
