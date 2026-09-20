const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  try {
    const client = await drive.getOAuth2Client();
    res.json({ url: drive.getAuthUrl(client) });
  } catch (e) {
    res.status(400).json({ error: { message: e.message } });
  }
};
