export async function markRepliesRead(ids: string[]) {
  const response = await fetch('/api/community/notifications', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw new Error('reply_read_failed');
  document.dispatchEvent(new Event('an:replies-updated'));
  try { localStorage.setItem('an:replies-updated', String(Date.now())); } catch { /* Storage may be disabled. */ }
}
