import './styles.css';
import 'dockview-react/dist/styles/dockview.css';
import '@glideapps/glide-data-grid/dist/index.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { errorMessage } from './lib/errors';
import { connectMain } from './lib/main-client';
import { watchConnectionEvents } from './state/connections';
import { queryClient } from './state/data';
import { watchMetadata } from './state/metadata';

/** Renderer entry: connect to main over the port the preload forwards, then render. */
async function start(): Promise<void> {
  const root = createRoot(document.getElementById('root')!);
  try {
    await connectMain();
  } catch (error) {
    root.render(
      <p role="alert" style={{ padding: 16 }}>
        Querybara could not start: {errorMessage(error)}
      </p>,
    );
    return;
  }
  void watchConnectionEvents();
  watchMetadata();
  root.render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

void start();
