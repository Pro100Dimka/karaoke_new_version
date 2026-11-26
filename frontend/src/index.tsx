import { setMotionFrameRate } from '@neo-ui-kit/react';
import '@neo-ui-kit/react/styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';

import { lazy, Suspense } from 'react';
import './styles.css';

const App = lazy(() =>
  window.location.hash === '#legal'
    ? import('./app/LegalDocuments')
    : import('./pages'),
);

setMotionFrameRate(60);

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
    <Suspense>
      <App />
    </Suspense>
  </QueryClientProvider>,
);
