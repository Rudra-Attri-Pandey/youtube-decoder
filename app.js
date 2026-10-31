document.addEventListener('DOMContentLoaded', () => {
  // XSS guard: escape server strings before innerHTML
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const ytUrl = document.getElementById('yt-url');
  const btnDecode = document.getElementById('btn-decode');
  const notice = document.getElementById('decode-notice');

  const stepTranscript = document.getElementById('step-transcript');
  const stepLlm = document.getElementById('step-llm');
  const stepFormat = document.getElementById('step-format');

  const insightsList = document.getElementById('insights-list');
  const exportsPanel = document.getElementById('exports-panel');

  // Last real decode result — the single source for all exports.
  let state = null; // { videoId, title, mode, ai, insights[], segments[], segmentCount, notice }

  function setStep(el, cls) { el.className = `tracker-item ${cls}`.trim(); }
  function showNotice(msg, kind) {
    if (!msg) { notice.classList.add('hidden'); notice.textContent = ''; return; }
    notice.classList.remove('hidden');
    notice.className = `notice ${kind || 'info'}`;
    notice.textContent = msg;
  }
  function setBusy(busy, label) {
    btnDecode.disabled = busy;
    btnDecode.textContent = busy ? (label || 'Decoding…') : 'Decode Video';
  }

  function renderInsights() {
    if (!state || !state.insights || !state.insights.length) {
      insightsList.innerHTML = '<tr class="empty-state"><td colspan="4">No data.</td></tr>';
      return;
    }
    insightsList.innerHTML = state.insights.map((ins) => `
      <tr>
        <td class="time-stamp">${escapeHtml(ins.time)}</td>
        <td>${escapeHtml(ins.text)}</td>
        <td><span class="category-badge">${escapeHtml(ins.cat)}</span></td>
        <td><span class="confidence-val ${escapeHtml(String(ins.conf).toLowerCase())}">${escapeHtml(ins.conf)}</span></td>
      </tr>`).join('');
  }

  function renderError(message) {
    insightsList.innerHTML = `<tr class="empty-state"><td colspan="4">⚠ ${escapeHtml(message)}</td></tr>`;
  }

  btnDecode.addEventListener('click', async () => {
    const urlVal = ytUrl.value.trim();
    if (!urlVal) { showNotice('Please enter a YouTube video URL first.', 'error'); return; }
    if (urlVal.length > 2000) { showNotice('URL exceeds 2000 characters.', 'error'); return; }

    // Reset: fetch stage
    state = null;
    exportsPanel.classList.add('hidden');
    showNotice('', null);
    renderError('Contacting backend…');
    setStep(stepTranscript, 'active');
    setStep(stepLlm, '');
    setStep(stepFormat, '');
    setBusy(true, 'Fetching…');

    let res;
    try {
      res = await fetch('/api/decode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlVal }),
      });
    } catch {
      setBusy(false);
      setStep(stepTranscript, '');
      renderError('Could not reach the backend. Is `npm start` running?');
      showNotice('Network error: backend unreachable. Start it with `npm start`.', 'error');
      return;
    }

    let data = null;
    try { data = await res.json(); } catch { /* fall through */ }

    if (!res.ok) {
      // Honest errors: 400 invalid URL, 422 no captions, 429 rate limit, 5xx.
      setBusy(false);
      setStep(stepTranscript, '');
      const msg = (data && data.error) || `Request failed (HTTP ${res.status}).`;
      renderError(msg);
      showNotice(msg, 'error');
      return;
    }

    // transcript stage done (real data arrived)
    state = data;
    setStep(stepTranscript, 'completed');

    // AI stage: real AI insights, or honestly skipped in transcript-only mode
    if (state.ai) {
      setStep(stepLlm, 'completed');
      showNotice(
        `AI insights for “${state.title || state.videoId}” (${state.segmentCount} transcript segments via ${state.transcriptVia}).`,
        'info'
      );
    } else {
      setStep(stepLlm, 'skipped');
      showNotice(state.notice || 'Transcript only — add API key for AI insights.', 'warn');
    }

    // format stage: render + exports
    renderInsights();
    setStep(stepFormat, 'completed');
    setBusy(false);
    exportsPanel.classList.remove('hidden');
    document.querySelectorAll('.btn-download').forEach((btn) => {
      btn.disabled = false;
      btn.classList.remove('downloading', 'completed');
      const label = btn.dataset.label || btn.dataset.format.toUpperCase();
      btn.textContent = btn.dataset.format === 'copy' ? label : `Download ${label}`;
      const pb = document.getElementById(`pb-${btn.dataset.format}`);
      if (pb) pb.style.width = '0%';
    });
    document.querySelectorAll('.export-card').forEach((c) => c.classList.remove('completed'));
  });

  // ---- Real exports, all built from `state` ----
  function baseName() {
    const id = (state && state.videoId) || 'video';
    return `decoded_${id}`;
  }
  function download(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  }
  function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }

  const builders = {
    csv() {
      const rows = [['Timestamp', 'Insight', 'Category', 'Confidence'],
        ...state.insights.map((i) => [i.time, i.text, i.cat, i.conf])];
      return rows.map((r) => r.map(csvCell).join(',')).join('\n');
    },
    txt() {
      const head = `${state.title || state.videoId}\nhttps://www.youtube.com/watch?v=${state.videoId}\nMode: ${state.mode}\n\nTRANSCRIPT\n`;
      const body = state.segments.map((s) => `[${s.start}] ${s.text}`).join('\n');
      const foot = `\n\nKEY INSIGHTS\n${state.insights.map((i) => `[${i.time}] (${i.cat}, ${i.conf}) ${i.text}`).join('\n')}\n`;
      return head + body + foot;
    },
    md() {
      const lines = [
        `# ${state.title || state.videoId}`,
        '',
        `https://www.youtube.com/watch?v=${state.videoId} · Mode: ${state.mode} · Segments: ${state.segmentCount}`,
        '',
        '## Key insights',
        '',
        ...state.insights.map((i) => `- **[${i.time}]** ${i.text} _( ${i.cat} · ${i.conf} )_`),
        '',
        '## Transcript',
        '',
        ...state.segments.map((s) => `- \`[${s.start}]\` ${s.text}`),
        '',
      ];
      return lines.join('\n');
    },
    json() {
      return JSON.stringify({
        videoId: state.videoId, title: state.title, mode: state.mode,
        ai: state.ai, simulated: false, segmentCount: state.segmentCount,
        insights: state.insights, segments: state.segments,
      }, null, 2);
    },
  };

  document.querySelectorAll('.btn-download').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state) return;
      const format = btn.dataset.format;
      const progressBar = document.getElementById(`pb-${format}`);
      const parentCard = btn.closest('.export-card');

      if (format === 'copy') {
        try {
          await navigator.clipboard.writeText(builders.md());
          btn.textContent = 'Copied ✓';
          setTimeout(() => { btn.textContent = btn.dataset.label || 'Copy to clipboard'; }, 2000);
        } catch {
          showNotice('Clipboard blocked by the browser — use Download .md instead.', 'error');
        }
        return;
      }

      btn.disabled = true;
      btn.classList.add('downloading');
      btn.textContent = 'Compiling…';
      let progress = 0;
      const mime = { csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json' }[format];
      const interval = setInterval(() => {
        progress += 25;
        if (progressBar) progressBar.style.width = `${progress}%`;
        if (progress >= 100) {
          clearInterval(interval);
          download(`${baseName()}.${format}`, mime, builders[format]());
          btn.disabled = false;
          btn.classList.remove('downloading');
          btn.classList.add('completed');
          btn.textContent = 'Downloaded ✓';
          if (parentCard) parentCard.classList.add('completed');
        }
      }, 120);
    });
  });
});
