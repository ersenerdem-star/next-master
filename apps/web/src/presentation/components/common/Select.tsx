type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  name?: string;
  autoComplete?: string;
  fieldClassName?: string;
  inputClassName?: string;
  disabled?: boolean;
};

export function Select({ label, value, options, onChange, name, autoComplete, fieldClassName = "", inputClassName = "", disabled = false }: SelectProps) {
  return (
    <label className={`field ${fieldClassName}`.trim()}>
      {label ? <span className="field__label">{label}</span> : null}
      <select className={`field__input ${inputClassName}`.trim()} name={name} autoComplete={autoComplete} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
