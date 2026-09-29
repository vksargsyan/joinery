import { ENGINES } from '@joinery/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { closeTransferDb, transferDbApi, useTransferDbDialog } from '../../state/transfer-db/api';
import {
  TransferDbWizard,
  stepProblem,
  stepsFor,
  type TransferSource,
  type TransferStep,
} from '../../state/transfer-db/wizard';
import { StepBar } from '../jobs/shared';
import { Button, Modal } from '../ui';
import { MappingStep } from './MappingStep';
import { OptionsStep } from './OptionsStep';
import { ReviewStep } from './ReviewStep';
import { SourceStep, TargetStep } from './EndpointSteps';

/**
 * The data transfer wizard's dialog (spec §12): source objects, target connection, options,
 * column and type mapping, review, run. The state machine in state/transfer-db does the work
 * and the job runner plans and runs the transfer; this renders each step.
 */

const STEP_LABELS: Readonly<Record<TransferStep, string>> = {
  source: 'Source',
  target: 'Target',
  options: 'Options',
  mapping: 'Mapping',
  review: 'Review',
};

/** Whichever transfer wizard is open. */
export function TransferDbHost() {
  const source = useTransferDbDialog((state) => state.source);
  if (source === undefined) return null;
  return <TransferDbDialog source={source} onClose={closeTransferDb} />;
}

export function TransferDbDialog(props: {
  readonly source: TransferSource;
  readonly onClose: () => void;
}) {
  const [wizard] = useState(() => new TransferDbWizard(props.source, transferDbApi()));
  const state = useStore(wizard.store);
  useEffect(() => {
    void wizard.open();
  }, [wizard]);
  const problem = stepProblem(state);
  const steps = stepsFor(state.source?.engine);
  const run = async (): Promise<void> => {
    if (await wizard.run()) props.onClose();
  };
  const destructive = (state.plan?.destructive.length ?? 0) > 0;
  const from = state.source
    ? `${state.source.profileName} (${ENGINES[state.source.engine].displayName})`
    : '';
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Transfer data"
      description={from ? `From ${from}` : 'Reading the connection…'}
      width="w-[960px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={state.error ? 'alert' : undefined}
          >
            {state.error ?? ''}
          </span>
          {(state.busy ?? (state.planning ? 'Planning…' : undefined)) && (
            <span className="self-center text-xs text-muted" aria-live="polite">
              {state.busy ?? 'Planning…'}
            </span>
          )}
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {state.step !== 'source' && (
            <Button onClick={() => wizard.back()} disabled={state.busy !== undefined}>
              Back
            </Button>
          )}
          {state.step === 'review' ? (
            <Button
              variant={destructive || state.target?.production ? 'danger' : 'primary'}
              onClick={() => void run()}
              disabled={problem !== undefined || state.busy !== undefined || state.planning}
            >
              Transfer
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void wizard.next()}
              disabled={problem !== undefined || state.busy !== undefined}
              title={problem}
            >
              Next
            </Button>
          )}
        </>
      }
    >
      <div data-testid="transfer-db-wizard">
        <StepBar steps={steps} labels={STEP_LABELS} current={state.step} />
        {state.step === 'source' && <SourceStep wizard={wizard} state={state} />}
        {state.step === 'target' && <TargetStep wizard={wizard} state={state} />}
        {state.step === 'options' && <OptionsStep wizard={wizard} state={state} />}
        {state.step === 'mapping' && <MappingStep wizard={wizard} state={state} />}
        {state.step === 'review' && <ReviewStep state={state} />}
        {problem && !state.error && state.step !== 'review' && (
          <p className="mt-2 text-xs text-muted">{problem}</p>
        )}
      </div>
    </Modal>
  );
}
