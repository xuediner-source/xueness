import React from 'react';
import { Select } from '../../ui/Select';
import { t } from '../../i18n';

export function ComposerWorkspaceSelect({ busy, loading, ...props }: Omit<React.ComponentProps<typeof Select>, 'disabled'> & { busy: boolean; loading: boolean }) {
  return <Select {...props} aria-label={t('选择工作区')} disabled={busy} aria-busy={loading} />;
}
