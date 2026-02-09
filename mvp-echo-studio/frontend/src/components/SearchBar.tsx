interface Props {
  value: string;
  onChange: (value: string) => void;
  resultCount?: number;
}

export default function SearchBar({ value, onChange, resultCount }: Props) {
  return (
    <div className="relative">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
        />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search transcript..."
        className="w-full pl-10 pr-16 py-2 bg-surface-2 border border-border rounded-lg text-sm text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-mvp-blue"
      />
      {value && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {resultCount !== undefined && (
            <span className="text-xs text-gray-500">{resultCount} found</span>
          )}
          <button
            onClick={() => onChange("")}
            className="text-gray-500 hover:text-gray-300"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
