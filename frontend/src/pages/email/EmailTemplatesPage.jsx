import React, { useEffect, useState, useRef } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { C, FONT } from '../../constants.js';

const G = '#16a34a';
async function insertImagesIntoQuill(quill, files) {
  const fileArray = Array.from(files);
  for (const file of fileArray) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const json = await res.json();
      if (json.url) {
        const absoluteUrl = window.location.origin + json.url;
        const range = quill.getSelection(true) || { index: quill.getLength() };
        quill.insertEmbed(range.index, 'image', absoluteUrl, 'user');
        // Set inline size limits directly on the <img> tag so it displays
        // correctly in actual email clients (which ignore external CSS).
        setTimeout(() => {
          const imgs = quill.root.querySelectorAll(`img[src="${absoluteUrl}"]`);
          const img = imgs[imgs.length - 1];
          if (img) {
            img.setAttribute(
              'style',
              'max-width:300px;width:100%;height:auto;display:block;margin:10px 0;'
            );
          }
        }, 0);
        quill.setSelection(range.index + 1, 0);
        quill.insertText(range.index + 1, '\n', 'user');
      }
    } catch (err) {
      console.error('Image upload failed:', err);
    }
  }
}
function buildQuillModules(quillRef) {
  return {
    toolbar: {
      container: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ color: [] }, { background: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['link', 'image'],
        ['clean'],
      ],
      handlers: {
        image: function () {
          const input = document.createElement('input');
          input.setAttribute('type', 'file');
          input.setAttribute('accept', 'image/*');
          input.setAttribute('multiple', 'true');
          input.onchange = () => {
            const quill = quillRef.current?.getEditor();
            if (quill && input.files && input.files.length > 0) {
              insertImagesIntoQuill(quill, input.files);
            }
          };
          input.click();
        },
      },
    },
  };
}

export default function EmailTemplatesPage() {
  const quillRef = useRef(null);
  const quillModules = React.useMemo(() => buildQuillModules(quillRef), []);
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null); // null = not editing, {} = new, {...} = existing
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const load = () => {
    fetch('/api/email/templates', { credentials: 'include' })
      .then(r => r.json())
      .then(res => setTemplates(res.data || []))
      .catch(() => {});
  };

  useEffect(() => { load(); }, []);

  function startNew() {
    setEditing({});
    setTitle('');
    setSubject('');
    setHtmlBody('');
    setStatus('');
  }

  function startEdit(t) {
    setEditing(t);
    setTitle(t.title);
    setSubject(t.subject);
    setHtmlBody(t.html_body);
    setStatus('');
  }

  function cancelEdit() {
    setEditing(null);
    setStatus('');
  }
async function save() {
    const plainText = htmlBody.replace(/<[^>]*>/g, '').trim();
    const hasImage = /<img\s/i.test(htmlBody);
    if (!title || !subject || (!plainText && !hasImage)) {
      setStatus('Title, subject, and body are all required — the body needs actual text or at least one image.');
      return;
    }
    setSaving(true);
    setStatus('');
    try {
      const isNew = !editing.id;
      const url = isNew ? '/api/email/templates' : `/api/email/templates/${editing.id}`;
      const method = isNew ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, subject, htmlBody }),
      });
      const json = await res.json();
      if (json.success) {
        setEditing(null);
        load();
      } else {
        setStatus(json.error || 'Failed to save template.');
      }
    } catch {
      setStatus('Failed to save template.');
    }
    setSaving(false);
  }

  async function remove(id) {
    if (!confirm('Delete this template?')) return;
    await fetch(`/api/email/templates/${id}`, { method: 'DELETE', credentials: 'include' });
    load();
  }

  return (
    <div style={{ padding: 28, fontFamily: FONT, color: C.text, maxWidth: 900 }}>
      <style>{`
        .ql-toolbar.ql-snow { background: ${C.pageBg}; border-color: ${C.border} !important; border-radius: 8px 8px 0 0; }
        .ql-container.ql-snow { background: ${C.pageBg}; border-color: ${C.border} !important; border-radius: 0 0 8px 8px; font-family: ${FONT}; font-size: 13px; }
        .ql-editor { color: ${C.text}; min-height: 220px; }
        .ql-editor.ql-blank::before { color: ${C.textMuted}; font-style: normal; }
        .ql-snow .ql-stroke { stroke: ${C.textMuted}; }
        .ql-snow .ql-fill { fill: ${C.textMuted}; }
        .ql-snow .ql-picker { color: ${C.textMuted}; }
        .ql-toolbar.ql-snow .ql-picker-options { background: ${C.cardBg}; }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: -0.5 }}>Email Templates</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>Create different messages for different customers</div>
        </div>
        {!editing && (
          <button
            onClick={startNew}
            style={{ padding: '10px 20px', background: G, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >+ New Template</button>
        )}
      </div>

      {editing && (
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>
            {editing.id ? 'Edit Template' : 'New Template'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Template Name (internal label)</div>
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. New Arrival - Sarees"
                style={{ width: '100%', padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Subject Line</div>
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="e.g. New Collection Just Dropped!"
                style={{ width: '100%', padding: '10px 14px', background: C.pageBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Email Body</div>
              <ReactQuill
                ref={quillRef}
                theme="snow"
                value={htmlBody}
                onChange={setHtmlBody}
                modules={quillModules}
                placeholder="Hi {{name}}, check out our new collection..."
              />
            </div>
            {status && <div style={{ fontSize: 12, color: '#ef4444' }}>{status}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={save}
                disabled={saving}
                style={{ padding: '10px 20px', background: G, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >{saving ? 'Saving...' : 'Save Template'}</button>
              <button
                onClick={cancelEdit}
                style={{ padding: '10px 20px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, color: C.textMuted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          Saved Templates ({templates.length})
        </div>
        {templates.length === 0 ? (
          <div style={{ fontSize: 13, color: C.textMuted }}>No templates yet. Create one above.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {templates.map(t => (
              <div key={t.id} style={{ padding: '12px 14px', background: C.pageBg, borderRadius: 8, border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t.title}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{t.subject}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 14 }}>
                    <button
                      onClick={() => startEdit(t)}
                      style={{ background: 'none', border: 'none', color: G, cursor: 'pointer', fontSize: 12 }}
                    >Edit</button>
                    <button
                      onClick={() => remove(t.id)}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12 }}
                    >Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
