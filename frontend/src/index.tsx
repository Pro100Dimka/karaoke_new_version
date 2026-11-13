import { setDecorationLevel, setMotionFrameRate } from '@neo-ui-kit/react';
import '@neo-ui-kit/react/styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';

import App from './pages';
import './styles.css';

setMotionFrameRate(60);
setDecorationLevel('light');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, networkMode: 'always' },
    mutations: { networkMode: 'always' },
  },
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
