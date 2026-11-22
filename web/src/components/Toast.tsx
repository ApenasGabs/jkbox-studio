import { useCallback, useState } from 'react';

export function useToast() {
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const show = useCallback((text: string, error = false) => {
    setMessage({ text, error });
    window.setTimeout(() => setMessage((current) => (current?.text === text ? null : current)), 3500);
  }, []);
  const node = message ? (
    <div
      role="status"
      className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm shadow-lg ${
        message.error ? 'bg-red-500 text-white' : 'bg-white text-zinc-900'
      }`}
    >
      {message.text}
    </div>
  ) : null;
  return { show, node };
}
