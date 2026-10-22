import crypto from 'node:crypto';
import path from 'node:path';
import { create as contentDisposition } from 'content-disposition';
import { query, queryOne } from './db.js';
import { storage } from './storage.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MILESTONE = 10;
export const ACCOUNT_QUOTA_BYTES = 200 * 1024 * 1024;

// Accepted types, recognized from the first bytes of the file, never from its name
// or the type sent by the browser. Images open in the page; PDF and text are downloaded.
const TYPES = {
  png: { mime: 'image/png', extensions: ['.png'], inline: true },
  jpg: { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], inline: true },
  gif: { mime: 'image/gif', extensions: ['.gif'], inline: true },
  webp: { mime: 'image/webp', extensions: ['.webp'], inline: true },
  pdf: { mime: 'application/pdf', extensions: ['.pdf'], inline: false },
  txt: { mime: 'text/plain; charset=utf-8', extensions: ['.txt', '.md', '.csv', '.log'], inline: false },
};
const TEXT_EXTENSIONS = new Set(TYPES.txt.extensions);
const MARKUP = /^\s*<(!doctype|html|head|body|svg|\?xml|script|iframe|object|embed|xsl)\b/i;

function startsWith(buffer, bytes, offset = 0) {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}
const ascii = (text) => [...text].map((char) => char.charCodeAt(0));

// Returns the detected type, or null for anything not on the list
// (SVG, HTML, executables, archives, unknown binaries…).
export function detectType(buffer, originalName = '') {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(buffer, ascii('GIF87a')) || startsWith(buffer, ascii('GIF89a'))) return 'gif';
  if (startsWith(buffer, ascii('RIFF')) && startsWith(buffer, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(buffer, ascii('%PDF-'))) return 'pdf';

  // Plain text has no signature: it must be named like a text file, be valid UTF-8
  // without control bytes, and not be markup such as HTML or SVG.
  if (!TEXT_EXTENSIONS.has(path.extname(originalName).toLowerCase()) || buffer.length === 0) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return null;
  if (MARKUP.test(text.replace(/^﻿/, ''))) return null;
  return 'txt';
}

// What the upload form and its error messages show: the real limits and accepted types.
export const UPLOAD_RULES = {
  types: Object.values(TYPES).flatMap((info) => info.extensions).join(', '),
  accept: Object.values(TYPES).flatMap((info) => [info.mime.split(';')[0], ...info.extensions]).join(','),
  size: MAX_FILE_BYTES / 1024 / 1024,
  count: MAX_FILES_PER_MILESTONE,
  quota: ACCOUNT_QUOTA_BYTES / 1024 / 1024,
};

export function typeInfo(type) {
  return TYPES[type];
}

// Display name: no folders, no control or reserved characters, at most 120 characters,
// and an extension that matches the real content.
export function cleanName(originalName, type) {
  const base = path
    .basename(String(originalName ?? '').replaceAll('\\', '/'))
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '')
    .trim();
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length).replace(/^\.+/, '').trim().slice(0, 120) || 'file';
  const { extensions } = TYPES[type];
  return stem + (extensions.includes(ext) ? ext : extensions[0]);
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function newStorageKey() {
  return `files/${crypto.randomBytes(24).toString('hex')}`;
}

export function findFile(milestoneId, fileId) {
  const id = Number(fileId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return queryOne('SELECT * FROM files WHERE id = $1 AND milestone_id = $2', [id, milestoneId]);
}

export function listFiles(milestoneId) {
  return query('SELECT * FROM files WHERE milestone_id = $1 ORDER BY id', [milestoneId]);
}

export async function usedBytes(userId) {
  const rows = await query(
    `SELECT COALESCE(SUM(f.size), 0)::bigint AS used
       FROM files f
       JOIN milestones m ON m.id = f.milestone_id
       JOIN projects p ON p.id = m.project_id
      WHERE p.user_id = $1`,
    [userId],
  );
  return Number(rows[0].used);
}

export function isImage(file) {
  return file.mime.startsWith('image/');
}

// Streams a stored file with headers that stop the browser from guessing its type
// or running anything in it.
export async function sendFile(res, file) {
  const type = Object.values(TYPES).find((info) => info.mime === file.mime);
  const body = await storage.read(file.storage_key);
  res.set({
    'Content-Type': file.mime,
    'Content-Length': String(file.size),
    'Content-Disposition': contentDisposition(file.name, { type: type?.inline ? 'inline' : 'attachment' }),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  body.on('error', (error) => {
    console.error('File stream failed:', error.message);
    res.destroy(error);
  });
  body.pipe(res);
}

// Storage keys of everything that a deletion is about to remove, collected before the rows go.
export async function storageKeys(sql, params) {
  const rows = await query(sql, params);
  return rows.map((row) => row.storage_key);
}
