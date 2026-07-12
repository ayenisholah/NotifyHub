import { createRoot } from 'react-dom/client';

import { NotifyHubInbox } from './NotifyHubInbox.js';
import type { MountHandle, NotifyHubInboxProps } from './types.js';

export function mount(element: Element, props: NotifyHubInboxProps): MountHandle {
  const root = createRoot(element);
  let mounted = true;
  root.render(<NotifyHubInbox {...props} />);
  return {
    unmount() {
      if (!mounted) return;
      mounted = false;
      root.unmount();
    },
  };
}
