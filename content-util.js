// content-util.js — small shared helpers for the isolated-world scripts
// (toast, HTML escaping, clipboard, point-name abbreviation).
function showToast(message) {
  const existing = document.querySelector('.worm-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'worm-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function editorCopyText(text) {
  return new Promise((resolve) => {
    const done = (ok) => resolve(!!ok);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(false));
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      done(document.execCommand('copy'));
      ta.remove();
    } catch (err) {
      done(false);
    }
  });
}

// Abbreviates a point type name: "Shard Points" → "SP", "Character Points" → "CP"
function abbreviatePointName(name) {
  if (!name) return 'Pts';
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return name; // single word kept as-is
  return words.map(w => w[0].toUpperCase()).join('');
}

