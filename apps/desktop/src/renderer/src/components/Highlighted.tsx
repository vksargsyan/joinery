import { matchParts } from '../state/sidebar-filter';

/** A name with the search's match in rust (Kiln's tree filter highlight). */
export function Highlighted(props: { readonly text: string; readonly search: string }) {
  const parts = matchParts(props.text, props.search);
  if (!parts) return <>{props.text}</>;
  return (
    <>
      {parts.before}
      <mark className="bg-transparent font-semibold text-rust">{parts.match}</mark>
      {parts.after}
    </>
  );
}
