const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  try {
    res.json({
      configured: drive.isConfigured(),
      connected: await drive.isConnected(),
      defaultFolderId: (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
      uploadFolderId: (process.env.GOOGLE_DRIVE_UPLOAD_FOLDER_ID || '').trim(),
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
