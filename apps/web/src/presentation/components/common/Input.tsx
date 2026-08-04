type InputProps = {
  label?: string;
  type?: string;
  value: string;
  placeholder?: string;
  name?: string;
  autoComplete?: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  disabled?: boolean;
};

export function Input({ label, type = "text", value, placeholder, name, autoComplete, onChange, onEnter, disabled = false }: InputProps) {
  return (
    <label className="field">
      {label ? <span className="field__label">{label}</span> : null}
      <input
        className="field__input"
        type={type}
        name={name}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
      />
    </label>
  );
}
