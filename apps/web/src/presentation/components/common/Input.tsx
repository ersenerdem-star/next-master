type InputProps = {
  label?: string;
  type?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function Input({ label, type = "text", value, placeholder, onChange, disabled = false }: InputProps) {
  return (
    <label className="field">
      {label ? <span className="field__label">{label}</span> : null}
      <input
        className="field__input"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
