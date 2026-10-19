import React, { useMemo } from 'react';
import { MapPin } from 'lucide-react';
import { Combobox, type ComboboxOption } from './Combobox';

export interface CityOption {
  name: string;
  countryCode?: string;
  region?: string;
}

// Suggestions only. The leads API takes the location as free text and passes it
// to the provider, so any city, state or region the user types is a valid
// filter — these lists exist to save typing, not to limit the choice.
const POPULAR_CITIES: Record<string, CityOption[]> = {
  US: [
    { name: 'San Francisco', countryCode: 'US', region: 'California' },
    { name: 'New York', countryCode: 'US', region: 'New York' },
    { name: 'Austin', countryCode: 'US', region: 'Texas' },
    { name: 'Seattle', countryCode: 'US', region: 'Washington' },
    { name: 'Boston', countryCode: 'US', region: 'Massachusetts' },
    { name: 'Los Angeles', countryCode: 'US', region: 'California' },
    { name: 'Chicago', countryCode: 'US', region: 'Illinois' },
    { name: 'Denver', countryCode: 'US', region: 'Colorado' },
    { name: 'Miami', countryCode: 'US', region: 'Florida' },
    { name: 'Atlanta', countryCode: 'US', region: 'Georgia' },
    { name: 'Dallas', countryCode: 'US', region: 'Texas' },
    { name: 'San Diego', countryCode: 'US', region: 'California' },
    { name: 'Washington, D.C.', countryCode: 'US', region: 'District of Columbia' },
  ],
  GB: [
    { name: 'London', countryCode: 'GB', region: 'England' },
    { name: 'Manchester', countryCode: 'GB', region: 'England' },
    { name: 'Birmingham', countryCode: 'GB', region: 'England' },
    { name: 'Edinburgh', countryCode: 'GB', region: 'Scotland' },
    { name: 'Cambridge', countryCode: 'GB', region: 'England' },
    { name: 'Oxford', countryCode: 'GB', region: 'England' },
    { name: 'Bristol', countryCode: 'GB', region: 'England' },
  ],
  IN: [
    { name: 'Bengaluru', countryCode: 'IN', region: 'Karnataka' },
    { name: 'Mumbai', countryCode: 'IN', region: 'Maharashtra' },
    { name: 'Delhi NCR', countryCode: 'IN', region: 'Delhi' },
    { name: 'Hyderabad', countryCode: 'IN', region: 'Telangana' },
    { name: 'Pune', countryCode: 'IN', region: 'Maharashtra' },
    { name: 'Chennai', countryCode: 'IN', region: 'Tamil Nadu' },
    { name: 'Gurugram', countryCode: 'IN', region: 'Haryana' },
  ],
  CA: [
    { name: 'Toronto', countryCode: 'CA', region: 'Ontario' },
    { name: 'Vancouver', countryCode: 'CA', region: 'British Columbia' },
    { name: 'Montreal', countryCode: 'CA', region: 'Quebec' },
    { name: 'Ottawa', countryCode: 'CA', region: 'Ontario' },
    { name: 'Calgary', countryCode: 'CA', region: 'Alberta' },
  ],
  DE: [
    { name: 'Berlin', countryCode: 'DE', region: 'Berlin' },
    { name: 'Munich', countryCode: 'DE', region: 'Bavaria' },
    { name: 'Frankfurt', countryCode: 'DE', region: 'Hesse' },
    { name: 'Hamburg', countryCode: 'DE', region: 'Hamburg' },
  ],
  SG: [
    { name: 'Singapore', countryCode: 'SG', region: 'Central' },
  ],
  AU: [
    { name: 'Sydney', countryCode: 'AU', region: 'New South Wales' },
    { name: 'Melbourne', countryCode: 'AU', region: 'Victoria' },
    { name: 'Brisbane', countryCode: 'AU', region: 'Queensland' },
  ],
  FR: [
    { name: 'Paris', countryCode: 'FR', region: 'Île-de-France' },
    { name: 'Lyon', countryCode: 'FR', region: 'Auvergne-Rhône-Alpes' },
  ],
  NL: [
    { name: 'Amsterdam', countryCode: 'NL', region: 'North Holland' },
    { name: 'Rotterdam', countryCode: 'NL', region: 'South Holland' },
  ],
  AE: [
    { name: 'Dubai', countryCode: 'AE', region: 'Dubai' },
    { name: 'Abu Dhabi', countryCode: 'AE', region: 'Abu Dhabi' },
  ],
};

// Global Fallback Tech Hubs when no country is selected
const GLOBAL_HUBS: CityOption[] = [
  { name: 'San Francisco', countryCode: 'US', region: 'California' },
  { name: 'New York', countryCode: 'US', region: 'New York' },
  { name: 'London', countryCode: 'GB', region: 'United Kingdom' },
  { name: 'Bengaluru', countryCode: 'IN', region: 'India' },
  { name: 'Singapore', countryCode: 'SG', region: 'Singapore' },
  { name: 'Berlin', countryCode: 'DE', region: 'Germany' },
  { name: 'Toronto', countryCode: 'CA', region: 'Canada' },
  { name: 'Sydney', countryCode: 'AU', region: 'Australia' },
  { name: 'Paris', countryCode: 'FR', region: 'France' },
  { name: 'Amsterdam', countryCode: 'NL', region: 'Netherlands' },
  { name: 'Dubai', countryCode: 'AE', region: 'UAE' },
  { name: 'Austin', countryCode: 'US', region: 'Texas' },
  { name: 'Seattle', countryCode: 'US', region: 'Washington' },
  { name: 'Tokyo', countryCode: 'JP', region: 'Japan' },
];

interface CitySelectProps {
  id?: string;
  value: string;
  onChange: (city: string) => void;
  selectedCountry?: string; // ISO code e.g. "US"
  disabled?: boolean;
  'aria-labelledby'?: string;
}

export const CitySelect: React.FC<CitySelectProps> = ({ value, onChange, selectedCountry = '', ...rest }) => {
  const options = useMemo<ComboboxOption[]>(() => {
    const code = selectedCountry.toUpperCase();
    const list = code ? POPULAR_CITIES[code] ?? [] : GLOBAL_HUBS;
    return list.map((c) => ({ value: c.name, label: c.name, hint: c.region }));
  }, [selectedCountry]);

  return (
    <Combobox
      {...rest}
      value={value}
      onChange={onChange}
      options={options}
      allowCustom
      placeholder="Any city or region"
      anyLabel="Any city or region"
      searchPlaceholder="Type a city, state or region…"
      emptyIcon={<MapPin className="w-4 h-4" />}
      emptyText="Type a location and press Enter"
    />
  );
};
