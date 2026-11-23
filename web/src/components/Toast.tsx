import { useCallback, useState } from 'react';

export function ToastBanner({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      role="status"
      className={`fixed bottom-6 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl px-4 py-2 text-center text-sm shadow-lg ${
        error ? 'bg-red-500 text-white' : 'bg-white text-zinc-900'
      }`}
    >
      {text}
    </div>
  );
}

export function useToast() {
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const show = useCallback((text: string, error = false) => {
    setMessage({ text, error });
    window.setTimeout(() => setMessage((current) => (current?.text === text ? null : current)), 3500);
  }, []);
  const node = message ? <ToastBanner text={message.text} error={message.error} /> : null;
  return { show, node };
}
