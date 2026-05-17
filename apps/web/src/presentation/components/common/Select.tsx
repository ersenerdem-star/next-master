type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  fieldClassName?: string;
  inputClassName?: string;
};

export function Select({ label, value, options, onChange, fieldClassName = "", inputClassName = "" }: SelectProps) {
  return (
    <label className={`field ${fieldClassName}`.trim()}>
      {label ? <span className="field__label">{label}</span> : null}
      <select className={`field__input ${inputClassName}`.trim()} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
