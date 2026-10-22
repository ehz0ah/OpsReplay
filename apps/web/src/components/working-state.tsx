/** @jsxRuntime automatic */
import { Loader } from '@mantine/core';
import type { ReactNode } from 'react';

export function WorkingState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="working-state" role="status" aria-live="polite">
      <Loader size="sm" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}
