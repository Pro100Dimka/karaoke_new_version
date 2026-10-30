import { Stack } from '@neo-ui-kit/react';
import { useRef } from 'react';
import LibrarySongs from './songs';

export const LibraryPage = () => {
  const pageRef = useRef<HTMLElement>(null);
  return <Stack as="main" ref={pageRef} style={{ height: '100%', minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}>
    <LibrarySongs pageRef={pageRef} />
  </Stack>;
};

export default LibraryPage;
