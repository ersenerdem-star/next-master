import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../i18n/I18nProvider';
import { CUSTOMER_MESSAGES_READ, messagingRequest, type MessageUnreadSummary } from '../../../infrastructure/api/customerMessagesApi';
import { Button } from './Button';

type Props = { portal?: boolean; scopeKey: string; onOpenMessages: (customerId?: string, customerName?: string) => void };

// Keep unread state in the authenticated shell, independent of the current page.
// Only an authoritative unread response can clear the alert; opening it or a
// temporary network failure must never acknowledge a customer's message.
export function PersistentMessageAlert({ portal = false, scopeKey, onOpenMessages }: Props) {
  const { locale } = useI18n();
  const tr = locale === 'tr';
  const scope = `${portal ? 'portal' : 'admin'}:${scopeKey}`;
  const [summary, setSummary] = useState<MessageUnreadSummary & { scope: string }>({ scope, totalUnread: 0, conversations: [] });

  useEffect(() => {
    let disposed = false;
    let request: AbortController | null = null;
    setSummary({ scope, totalUnread: 0, conversations: [] });
    async function refresh(replace = false) {
      if (disposed || document.visibilityState !== 'visible') return;
      if (request && !replace) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const data = await messagingRequest<MessageUnreadSummary>(portal, { action: 'unread' }, controller.signal);
        if (disposed || controller.signal.aborted) return;
        if (!Number.isSafeInteger(data.totalUnread) || data.totalUnread < 0 || !Array.isArray(data.conversations)) return;
        setSummary({ ...data, scope });
      } catch {
        // Retain the last confirmed unread count until the next successful poll.
      } finally {
        if (request === controller) request = null;
      }
    }
    const wake = () => { void refresh(true); };
    const read = (event: Event) => {
      if ((event as CustomEvent<{ portal: boolean }>).detail?.portal === portal) wake();
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener(CUSTOMER_MESSAGES_READ, read);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener(CUSTOMER_MESSAGES_READ, read);
    };
  }, [portal, scope]);

  if (summary.scope !== scope || summary.totalUnread < 1) return null;
  const conversation = summary.conversations[0];
  return createPortal(
    <aside className={`persistent-message-alert${portal ? ' persistent-message-alert--portal' : ''}`} aria-label={tr ? 'Okunmamış mesajlar' : 'Unread messages'}>
      <span className="persistent-message-alert__icon" aria-hidden="true">✉</span>
      <div className="persistent-message-alert__body">
        <div role="status" aria-live="polite" aria-atomic="true">
          <strong>{tr ? 'Okunmamış mesajınız var' : 'You have unread messages'}</strong>
          <p>{tr ? `${summary.totalUnread} okunmamış mesaj` : `${summary.totalUnread} unread message${summary.totalUnread === 1 ? '' : 's'}`}</p>
          {!portal && conversation?.customer_name ? <p className="persistent-message-alert__sender">{conversation.customer_name}</p> : null}
        </div>
        <Button onClick={() => onOpenMessages(conversation?.customer_id, conversation?.customer_name)}>{tr ? 'Mesajlara git' : 'Go to messages'}</Button>
      </div>
    </aside>, document.body,
  );
}
