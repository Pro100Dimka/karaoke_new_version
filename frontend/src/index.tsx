import '@neo-ui-kit/react/styles.css';
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import App from './pages';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, networkMode: 'always' },
    mutations: { networkMode: 'always' },
  },
});
focusManager.setEventListener((onFocus) => {
  const refresh = () => onFocus();
  const events = ['focus', 'visibilitychange'];
  events.forEach((event) => window.addEventListener(event, refresh));
  return () =>
    events.forEach((event) => window.removeEventListener(event, refresh));
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
