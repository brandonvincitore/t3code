export function GoalProgressBattery({ percent }: { readonly percent: number | null }) {
  const fillWidth = percent === null ? 0 : (14 * percent) / 100;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="7" width="18" height="10" rx="2" />
      <path d="M22 10v4" />
      {percent === null ? (
        <text
          x="11.5"
          y="14.2"
          textAnchor="middle"
          fill="currentColor"
          stroke="none"
          fontSize="8"
          fontWeight="600"
        >
          ?
        </text>
      ) : (
        <rect
          x="4.5"
          y="9"
          width={fillWidth}
          height="6"
          rx="0.8"
          fill="currentColor"
          stroke="none"
        />
      )}
    </svg>
  );
}
