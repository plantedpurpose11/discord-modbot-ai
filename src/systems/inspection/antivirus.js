const net = require('node:net');
function scanAntivirus(buffer, env = process.env) {
  if (!env.CLAMAV_HOST) return Promise.resolve('disabled');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: env.CLAMAV_HOST, port: Number(env.CLAMAV_PORT || 3310) });
    const timer = setTimeout(() => socket.destroy(new Error('Antivirus timed out')), 5000);
    let answer = '';
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); reject(new Error('Antivirus connection closed before scan completed')); });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const length = Buffer.alloc(4); length.writeUInt32BE(buffer.length);
      socket.write(length); socket.write(buffer); socket.write(Buffer.alloc(4));
    });
    socket.on('data', data => {
      answer += data.toString('utf8');
      if (answer.length > 4096) { socket.destroy(new Error('Invalid antivirus response')); return; }
      if (answer.includes('\0')) {
        const result = answer.split('\0')[0];
        socket.destroy();
        if (result === 'stream: OK') resolve('clean');
        else if (/^stream: .+ FOUND$/.test(result)) resolve('infected');
        else reject(new Error('Antivirus could not complete scan'));
      }
    });
    socket.on('end', () => { if (!answer.includes('\0')) reject(new Error('Incomplete antivirus response')); });
  });
}
module.exports = { scanAntivirus };
