import React from 'react';

interface BrandLogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  showSubtitle?: boolean;
  iconOnly?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ 
  className = '', 
  size = 'md',
  showSubtitle = false,
  iconOnly = false
}) => {
  const iconSizes = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-7 h-7',
  };

  const textSizes = {
    sm: 'text-sm font-semibold tracking-tight',
    md: 'text-base font-semibold tracking-tight',
    lg: 'text-xl font-bold tracking-tight',
  };

  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      {/* Geometric soundwave / radar mark */}
      <div className={`flex items-center justify-center bg-[#141414] text-white p-1.5 rounded-none flex-shrink-0`}>
        <svg 
          className={iconSizes[size]} 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2.2" 
          strokeLinecap="square"
        >
          <path d="M4 10v4" />
          <path d="M8 6v12" />
          <path d="M12 2v20" />
          <path d="M16 6v12" />
          <path d="M20 10v4" />
        </svg>
      </div>

      {!iconOnly && (
        <div className="flex flex-col">
          <span className={`${textSizes[size]} text-[#141414] uppercase tracking-wider font-mono`}>
            Echo
          </span>
          {showSubtitle && (
            <span className="text-[10px] text-[#8a8a86] tracking-tight uppercase font-mono">
              Social Lead Intelligence
            </span>
          )}
        </div>
      )}
    </div>
  );
};
