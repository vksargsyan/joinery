import { tableOptionCatalog, type TableOptionInfo, type ValidationIssue } from '@querybara/sync';
import { useMemo } from 'react';

import { issuesAt, type DesignerForm } from '../../state/designer/form';
import { useDesignerState, type TableDesigner } from '../../state/designer';
import { Issues, Labeled, SelectField, TextArea, TextField } from './fields';

/**
 * The Options tab (spec §8: engine, charset, collation, tablespace...) from the engine's option
 * catalogue, and the Comment tab. An emptied option is removed, so the server default applies.
 */
export function OptionsTab(props: {
  readonly designer: TableDesigner;
  readonly form: DesignerForm;
  readonly issues: readonly ValidationIssue[];
}) {
  const { designer, form, issues } = props;
  const version = useDesignerState(designer, (s) => s.serverVersion);
  const catalog = useMemo(() => tableOptionCatalog(form.engine, version), [form.engine, version]);
  const set = (key: string, value: string): void => {
    const options = { ...form.options };
    if (value === '') delete options[key];
    else options[key] = value;
    designer.setForm({ ...form, options });
  };
  const known = new Set(catalog.map((o) => o.key));
  const others = Object.entries(form.options).filter(([key]) => !known.has(key));
  return (
    <div className="flex flex-col gap-3 p-3">
      {catalog.map((option) => (
        <div key={option.key} className="flex flex-col gap-0.5">
          <OptionField
            option={option}
            value={form.options[option.key] ?? ''}
            onChange={(v) => set(option.key, v)}
            invalid={issuesAt(issues, `options.${option.key}`).length > 0}
          />
          <Issues issues={issuesAt(issues, `options.${option.key}`)} />
        </div>
      ))}
      {others.length > 0 && (
        <div className="flex flex-col gap-1 text-xs">
          <h4 className="font-semibold text-muted">Other options</h4>
          {others.map(([key, value]) => (
            <Labeled key={key} label={key} className="w-72">
              <TextField
                mono
                aria-label={key}
                value={value}
                onChange={(e) => set(key, e.target.value)}
              />
            </Labeled>
          ))}
        </div>
      )}
      <Issues issues={issuesAt(issues, 'options', { exact: true })} />
    </div>
  );
}

function OptionField(props: {
  readonly option: TableOptionInfo;
  readonly value: string;
  readonly invalid: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { option, value } = props;
  const id = `option-${option.key}`;
  let control;
  switch (option.kind) {
    case 'choice':
      control = (
        <SelectField
          id={id}
          aria-label={option.label}
          invalid={props.invalid}
          value={value}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="">(default)</option>
          {value !== '' && !option.values?.includes(value) && (
            <option value={value}>{value}</option>
          )}
          {option.values?.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </SelectField>
      );
      break;
    case 'boolean':
      control = (
        <SelectField
          id={id}
          aria-label={option.label}
          invalid={props.invalid}
          value={value}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="">(default)</option>
          <option value="true">on</option>
          <option value="false">off</option>
        </SelectField>
      );
      break;
    case 'integer':
    case 'number':
      control = (
        <TextField
          id={id}
          aria-label={option.label}
          type="number"
          invalid={props.invalid}
          min={option.min}
          max={option.max}
          step={option.kind === 'integer' ? 1 : 'any'}
          placeholder="default"
          value={value}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
      break;
    default:
      control = (
        <>
          <TextField
            id={id}
            aria-label={option.label}
            list={`${id}-values`}
            invalid={props.invalid}
            placeholder="default"
            value={value}
            onChange={(e) => props.onChange(e.target.value)}
          />
          {option.values && (
            <datalist id={`${id}-values`}>
              {option.values.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          )}
        </>
      );
  }
  return (
    <Labeled label={option.label} hint={option.description} className="w-80">
      {control}
    </Labeled>
  );
}

export function CommentTab(props: {
  readonly designer: TableDesigner;
  readonly form: DesignerForm;
  readonly issues: readonly ValidationIssue[];
}) {
  const { designer, form } = props;
  return (
    <div className="flex flex-col gap-1 p-3">
      <Labeled label="Table comment" className="w-full">
        <TextArea
          rows={6}
          aria-label="Table comment"
          className="font-sans"
          value={form.comment}
          onChange={(e) => designer.setForm({ ...form, comment: e.target.value })}
        />
      </Labeled>
      <Issues issues={issuesAt(props.issues, 'comment')} />
    </div>
  );
}
