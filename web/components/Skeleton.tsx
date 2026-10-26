/** A placeholder block while something loads (decorative: wrap groups in aria-busy). */
export default function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`skeleton block ${className}`} />;
}
