import React, { useMemo } from 'react';
import { Globe } from 'lucide-react';
import { Combobox, type ComboboxOption } from './Combobox';
import { COUNTRIES, POPULAR_CODES, type CountryOption } from './countries';

interface CountrySelectProps {
  id?: string;
  value: string; // ISO code or empty string
  onChange: (countryCode: string) => void;
  disabled?: boolean;
  'aria-labelledby'?: string;
}

export const CountrySelect: React.FC<CountrySelectProps> = ({ value, onChange, ...rest }) => {
  const options = useMemo<ComboboxOption[]>(() => {
    const byCode = new Map(COUNTRIES.map((c) => [c.code, c]));
    const toOption = (c: CountryOption, group: string): ComboboxOption => ({
      value: c.code,
      label: c.name,
      // Matched by the search box but not displayed: on Windows the flag
      // emoji already renders as the two code letters.
      keywords: c.code,
      icon: <span className="text-base leading-none">{c.flag}</span>,
      group,
    });
    const popular = POPULAR_CODES.map((code) => byCode.get(code)).filter((c): c is CountryOption => Boolean(c));
    const rest = COUNTRIES.filter((c) => !POPULAR_CODES.includes(c.code)).sort((a, b) => a.name.localeCompare(b.name));
    return [...popular.map((c) => toOption(c, 'Popular')), ...rest.map((c) => toOption(c, 'All countries'))];
  }, []);

  return (
    <Combobox
      {...rest}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Any country"
      anyLabel="Any country"
      searchPlaceholder="Search countries…"
      emptyIcon={<Globe className="w-4 h-4" />}
      emptyText="No country matches"
    />
  );
};
