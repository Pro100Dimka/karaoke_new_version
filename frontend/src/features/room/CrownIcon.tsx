/** The reference's crown: three points with balls, and a bar below. */
export const CrownIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4.2 8.6 7.6 14.2 12 6.4l4.4 7.8 3.4-5.6-1.2 7.8H5.4Z" fill="none" />
    <path d="M6 19.2h12" fill="none" />
    <circle cx="4" cy="7.6" r="1.25" fill="currentColor" />
    <circle cx="12" cy="5" r="1.25" fill="currentColor" />
    <circle cx="20" cy="7.6" r="1.25" fill="currentColor" />
  </svg>
);
