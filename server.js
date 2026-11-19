require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const PORT = process.env.PORT || 3004;
const DATA_DIR = path.join(__dirname, 'data');
const CONTENT_SEED_PATH = path.join(DATA_DIR, 'content.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// נשמר באותה תיקייה שמחוברת לדיסק הקבוע ברנדר, כדי שהתוכן לא יימחק באיפוס/עדכון
const CONTENT_PATH = path.join(UPLOADS_DIR, 'content.json');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(CONTENT_PATH)) {
  fs.copyFileSync(CONTENT_SEED_PATH, CONTENT_PATH);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
function readContent() {
  const content = readJson(CONTENT_PATH);
  if (!content.mediaLibrary) content.mediaLibrary = [];
  if (!content.recentDonations) content.recentDonations = [];
  if (!content.contact) content.contact = { phone: '', whatsapp: '', email: '' };
  return content;
}

function parseRecentDonations(text) {
  return (text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const commaIndex = line.indexOf(',');
      if (commaIndex === -1) return { name: line, amount: '' };
      return {
        name: line.slice(0, commaIndex).trim(),
        amount: line.slice(commaIndex + 1).trim()
      };
    });
}

// ---------- Cloudinary (persistent storage for images/video/content) ----------
const CLOUDINARY_ENABLED = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}
const CONTENT_BACKUP_URL = CLOUDINARY_ENABLED
  ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/elisheva-trumot/content.json`
  : null;

function uploadBuffer(buffer, { publicId, resourceType }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, resource_type: resourceType, overwrite: true, invalidate: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function backupContentToCloudinary(content) {
  if (!CLOUDINARY_ENABLED) return;
  try {
    await uploadBuffer(Buffer.from(JSON.stringify(content)), {
      publicId: 'elisheva-trumot/content.json',
      resourceType: 'raw'
    });
  } catch (err) {
    console.error('שגיאה בשמירת גיבוי התוכן ל-Cloudinary:', err.message);
  }
}

async function restoreContentFromCloudinaryIfAvailable() {
  if (!CLOUDINARY_ENABLED) return;
  try {
    const res = await fetch(CONTENT_BACKUP_URL + '?t=' + Date.now());
    if (res.ok) {
      const remoteContent = await res.json();
      writeJson(CONTENT_PATH, remoteContent);
      console.log('תוכן העמוד שוחזר מה-Cloudinary.');
    }
  } catch (err) {
    console.log('לא נמצא גיבוי קודם ב-Cloudinary (ייתכן שזו הפעלה ראשונה).');
  }
}

function getAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    return readJson(CONFIG_PATH).adminPassword;
  } catch {
    return null;
  }
}

function mediaUrl(value) {
  if (!value) return '';
  return value.startsWith('http') ? value : '/uploads/' + value;
}

const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// ---------- Public content API ----------
app.get('/api/content', (req, res) => {
  const content = readContent();
  content.heroPhoto = mediaUrl(content.heroPhoto);
  content.gallery = content.gallery.map(item => ({ ...item, file: mediaUrl(item.file) }));
  content.video = { ...content.video, file: mediaUrl(content.video.file) };
  delete content.mediaLibrary;
  res.json(content);
});

// ---------- Admin media library ----------
app.get('/admin/media-library', requireAuth, (req, res) => {
  const content = readContent();
  const library = content.mediaLibrary.map(id => ({ id, url: mediaUrl(id) }));
  res.json(library);
});

// ---------- Admin auth ----------
app.get('/admin/login', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8');
  const error = req.query.error ? '<div class="error">סיסמה שגויה</div>' : '';
  res.send(html.replace('__ERROR__', error));
});

app.post('/admin/login', (req, res) => {
  const adminPassword = getAdminPassword();
  if (adminPassword && req.body.password === adminPassword) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// ---------- Uploads ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

const uploadFields = upload.fields([
  { name: 'heroPhoto', maxCount: 1 },
  { name: 'gallery1', maxCount: 1 },
  { name: 'gallery2', maxCount: 1 },
  { name: 'gallery3', maxCount: 1 },
  { name: 'gallery4', maxCount: 1 },
  { name: 'videoFile', maxCount: 1 }
]);

async function storeUploadedFile(file, slug, resourceType) {
  const uniqueId = slug + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  if (CLOUDINARY_ENABLED) {
    const result = await uploadBuffer(file.buffer, {
      publicId: 'elisheva-trumot/' + uniqueId,
      resourceType
    });
    return result.secure_url;
  }
  const ext = path.extname(file.originalname) || '';
  const filename = uniqueId + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
  return filename;
}

function addToMediaLibrary(content, identifier) {
  content.mediaLibrary = content.mediaLibrary || [];
  if (!content.mediaLibrary.includes(identifier)) {
    content.mediaLibrary.unshift(identifier);
  }
}

app.post('/admin/save', requireAuth, uploadFields, async (req, res) => {
  try {
    const content = readContent();
    const body = req.body;
    const files = req.files || {};

    content.goal = parseInt(body.goal, 10) || 0;
    content.raised = parseInt(body.raised, 10) || 0;

    content.story.paragraph = body.paragraph || '';
    content.story.deviceNote = body.deviceNote || '';
    content.story.quote = body.quote || '';
    content.story.quoteCite = body.quoteCite || '';

    if (files.heroPhoto) {
      content.heroPhoto = await storeUploadedFile(files.heroPhoto[0], 'hero', 'image');
      addToMediaLibrary(content, content.heroPhoto);
    } else if (body.heroPhotoLibrary) {
      content.heroPhoto = body.heroPhotoLibrary;
    } else if (body.heroPhotoRemove) {
      content.heroPhoto = '';
    }

    for (let i = 1; i <= 4; i++) {
      const idx = i - 1;
      const fileKey = 'gallery' + i;
      const libraryKey = 'gallery' + i + 'Library';
      const removeKey = 'gallery' + i + 'Remove';
      const captionKey = 'gallery' + i + 'Caption';
      content.gallery[idx].caption = body[captionKey] || ('תמונה ' + i);
      if (files[fileKey]) {
        content.gallery[idx].file = await storeUploadedFile(files[fileKey][0], 'gallery-' + i, 'image');
        addToMediaLibrary(content, content.gallery[idx].file);
      } else if (body[libraryKey]) {
        content.gallery[idx].file = body[libraryKey];
      } else if (body[removeKey]) {
        content.gallery[idx].file = '';
      }
    }

    content.video.type = body.videoType || 'none';
    content.video.youtubeId = body.youtubeId || '';
    if (files.videoFile) {
      content.video.file = await storeUploadedFile(files.videoFile[0], 'video', 'video');
    }

    content.phrases = (body.phrases || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    content.recentDonations = parseRecentDonations(body.recentDonations);

    content.donate.bit = body.bit || '';
    content.donate.paybox = body.paybox || '';
    content.donate.bankName = body.bankName || '';
    content.donate.bankBranch = body.bankBranch || '';
    content.donate.bankAccount = body.bankAccount || '';

    content.contact = content.contact || {};
    content.contact.phone = body.contactPhone || '';
    content.contact.whatsapp = body.contactWhatsapp || '';
    content.contact.email = body.contactEmail || '';

    writeJson(CONTENT_PATH, content);
    await backupContentToCloudinary(content);

    res.redirect('/admin?saved=1');
  } catch (err) {
    console.error('שגיאה בשמירה:', err);
    res.status(500).send('שגיאה בשמירת השינויים: ' + err.message);
  }
});

restoreContentFromCloudinaryIfAvailable().then(() => {
  app.listen(PORT, () => {
    console.log('עמוד התרומות פעיל בכתובת http://localhost:' + PORT);
    console.log('פאנל ניהול: http://localhost:' + PORT + '/admin');
    console.log('אחסון קבצים: ' + (CLOUDINARY_ENABLED ? 'Cloudinary (קבוע)' : 'דיסק מקומי (זמני)'));
    if (!getAdminPassword()) {
      console.warn('אזהרה: לא הוגדרה סיסמת ניהול (ADMIN_PASSWORD). הכניסה לפאנל הניהול חסומה.');
    }
  });
});
