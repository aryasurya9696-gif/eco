import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import { useAuth } from '../../context/AuthContext';
import { useEcho } from '../../context/EchoContext';
import { PillInput } from '../common/PillInput';
import { ArrowRight, Check, Sparkles } from 'lucide-react';

interface OnboardingModalProps {
  isOpen: boolean;
  onComplete: () => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ isOpen, onComplete }) => {
  const { profile, updateProfile, completeOnboarding } = useAuth();
  const { saveInitialKeywords, suggestKeywordsFromOffer } = useEcho();

  const [step, setStep] = useState<number>(profile?.onboarding_step || 1);
  const [fullName, setFullName] = useState<string>(profile?.full_name || '');
  const [website, setWebsite] = useState<string>(profile?.website || '');
  const [coreOffer, setCoreOffer] = useState<string>(profile?.core_offer || '');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [isFinishing, setIsFinishing] = useState<boolean>(false);
  const [isSuccess, setIsSuccess] = useState<boolean>(false);

  // Sync step from profile if available
  useEffect(() => {
    if (profile?.onboarding_step && profile.onboarding_step > 0 && profile.onboarding_step <= 4) {
      setStep(profile.onboarding_step);
    }
    if (profile?.full_name) setFullName(profile.full_name);
    if (profile?.website) setWebsite(profile.website);
    if (profile?.core_offer) setCoreOffer(profile.core_offer);
  }, [profile]);

  // Auto-generate AI keyword suggestions on step 4 from coreOffer
  useEffect(() => {
    if (step === 4 && coreOffer.trim() && aiSuggestions.length === 0) {
      suggestKeywordsFromOffer(coreOffer, website).then((result) => {
        // The suggestion set is now structured; PillInput only needs phrases.
        const phrases = result?.suggestions?.map((s) => s.phrase).filter(Boolean) ?? [];
        if (phrases.length > 0) setAiSuggestions(phrases);
      }).catch(() => {});
    }
  }, [step, coreOffer, website, suggestKeywordsFromOffer, aiSuggestions.length]);

  if (!isOpen) return null;

  const nextStep = async (newStep: number) => {
    setStep(newStep);
    // Persist step to database
    await updateProfile({
      onboarding_step: newStep,
      full_name: fullName,
      website: website,
      core_offer: coreOffer,
    });
  };

  const handleFinish = async () => {
    if (keywords.length === 0 || isFinishing) return;
    setIsFinishing(true);

    try {
      // 1. Batch insert keyword rows
      await saveInitialKeywords(keywords);

      // 2. Fire canvas-confetti from the center of modal
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.5, x: 0.5 },
        colors: ['#141414', '#8a8a86', '#0a66c2', '#ffffff'],
      });

      // 3. Mark completed in profile
      await completeOnboarding({
        full_name: fullName,
        website: website,
        core_offer: coreOffer,
      });

      // 4. Show success state for ~900ms
      setIsSuccess(true);
      setTimeout(() => {
        setIsFinishing(false);
        onComplete();
      }, 950);
    } catch (err) {
      console.error('Error completing onboarding:', err);
      setIsFinishing(false);
    }
  };

  const isStep1Valid = fullName.trim().length > 0;
  const isStep2Valid = website.trim().length > 0;
  const isStep3Valid = coreOffer.trim().length > 0;
  const isStep4Valid = keywords.length > 0;

  const slideVariants = {
    initial: { opacity: 0, x: 28 },
    animate: { opacity: 1, x: 0, transition: { duration: 0.25, ease: 'easeOut' as const } },
    exit: { opacity: 0, x: -28, transition: { duration: 0.2, ease: 'easeIn' as const } },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Background Dim (dashboard visible but dimmed and pointer-events disabled) */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-[#000000]/45 backdrop-blur-[2px] transition-opacity"
      />

      {/* Modal Card */}
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="relative w-full max-w-lg bg-[#ffffff] border border-[#e3e3de] p-8 sm:p-10 shadow-2xl rounded-none z-10 overflow-hidden"
      >
        {/* Subtle top indicator bar */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-[#eeeeea]">
          <div
            className="h-full bg-[#141414] transition-all duration-300"
            style={{ width: `${(step / 4) * 100}%` }}
          />
        </div>

        {/* Step dots indicator (four clean dots at top) */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-1.5">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`w-2 h-2 rounded-full transition-all duration-200 ${
                  s === step
                    ? 'w-5 bg-[#141414]'
                    : s < step
                    ? 'bg-[#141414]'
                    : 'bg-[#deded8]'
                }`}
              />
            ))}
          </div>
          <span className="text-[11px] font-mono uppercase tracking-wider text-[#8a8a86]">
            Step {step} of 4
          </span>
        </div>

        {/* Success State Overlay */}
        {isSuccess ? (
          <div className="py-12 flex flex-col items-center justify-center text-center space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-[#141414] text-white flex items-center justify-center rounded-none shadow-md">
              <Check className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <h3 className="text-xl font-bold tracking-tight text-[#141414]">
                You're all set.
              </h3>
              <p className="text-xs text-[#8a8a86] font-mono mt-1">
                Preparing your live mention dashboard...
              </p>
            </div>
          </div>
        ) : (
          /* Step Flow */
          <div className="min-h-[260px] flex flex-col justify-between">
            <AnimatePresence mode="wait">
              {/* STEP 1: NAME */}
              {step === 1 && (
                <motion.div
                  key="step1"
                  variants={slideVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="space-y-5"
                >
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
                      What should we call you?
                    </h2>
                    <p className="text-xs text-[#8a8a86] mt-1 font-mono">
                      Your name or your company handle for your daily feed.
                    </p>
                  </div>

                  <div className="space-y-2 pt-2">
                    <label className="text-xs font-mono uppercase tracking-wider text-[#4a4a47]">
                      Full Name
                    </label>
                    <input
                      type="text"
                      autoFocus
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && isStep1Valid) nextStep(2);
                      }}
                      placeholder="e.g. David Vance"
                      className="w-full px-3.5 py-2.5 bg-white border border-[#e3e3de] rounded-none text-sm text-[#141414] placeholder:text-[#9b9b96] focus:outline-none focus:border-[#141414] transition-colors"
                    />
                  </div>
                </motion.div>
              )}

              {/* STEP 2: WEBSITE */}
              {step === 2 && (
                <motion.div
                  key="step2"
                  variants={slideVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="space-y-5"
                >
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
                      What's your website?
                    </h2>
                    <p className="text-xs text-[#8a8a86] mt-1 font-mono">
                      We'll track your product context and domain presence.
                    </p>
                  </div>

                  <div className="space-y-2 pt-2">
                    <label className="text-xs font-mono uppercase tracking-wider text-[#4a4a47]">
                      Website URL
                    </label>
                    <input
                      type="text"
                      autoFocus
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && isStep2Valid) nextStep(3);
                      }}
                      placeholder="e.g. acme.ai or https://acme.com"
                      className="w-full px-3.5 py-2.5 bg-white border border-[#e3e3de] rounded-none text-sm text-[#141414] placeholder:text-[#9b9b96] focus:outline-none focus:border-[#141414] transition-colors"
                    />
                    {website && !website.includes('.') && (
                      <span className="text-[11px] font-mono text-[#8a8a86] block">
                        Tip: include your domain extension (e.g. .com, .io, .ai)
                      </span>
                    )}
                  </div>
                </motion.div>
              )}

              {/* STEP 3: CORE OFFER */}
              {step === 3 && (
                <motion.div
                  key="step3"
                  variants={slideVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="space-y-5"
                >
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
                      What do you sell — or what does your company do?
                    </h2>
                    <p className="text-xs text-[#8a8a86] mt-1 font-mono">
                      1–2 sentences explaining your core offer or ICP problem.
                    </p>
                  </div>

                  <div className="space-y-2 pt-2">
                    <label className="text-xs font-mono uppercase tracking-wider text-[#4a4a47]">
                      Core Offer
                    </label>
                    <textarea
                      autoFocus
                      rows={3}
                      value={coreOffer}
                      onChange={(e) => setCoreOffer(e.target.value)}
                      placeholder="e.g. We build autonomous AI agents that qualify B2B inbound leads and automate sales outbound pipelines."
                      className="w-full px-3.5 py-2.5 bg-white border border-[#e3e3de] rounded-none text-sm text-[#141414] placeholder:text-[#9b9b96] focus:outline-none focus:border-[#141414] transition-colors resize-none"
                    />
                  </div>
                </motion.div>
              )}

              {/* STEP 4: KEYWORDS */}
              {step === 4 && (
                <motion.div
                  key="step4"
                  variants={slideVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="space-y-4"
                >
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-[#141414]">
                      What should we watch for?
                    </h2>
                    <p className="text-xs text-[#8a8a86] mt-1 font-mono">
                      Add up to 10 keywords. We'll search connected social channels and web communities daily for these mentions.
                    </p>
                  </div>

                  <div className="pt-1">
                    <PillInput
                      keywords={keywords}
                      onAdd={(kw) => setKeywords((prev) => [...prev, kw])}
                      onRemove={(kw) => setKeywords((prev) => prev.filter((k) => k !== kw))}
                      max={10}
                      suggestions={[
                        fullName ? fullName.toLowerCase() : 'your company',
                        ...aiSuggestions,
                      ]}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Bottom Actions */}
            <div className="flex items-center justify-between pt-8 border-t border-[#eeeeea] mt-6">
              {step > 1 ? (
                <button
                  type="button"
                  onClick={() => nextStep(step - 1)}
                  className="text-xs font-mono text-[#8a8a86] hover:text-[#141414] transition-colors cursor-pointer"
                >
                  ← Back
                </button>
              ) : (
                <div />
              )}

              {step < 4 ? (
                <button
                  type="button"
                  onClick={() => nextStep(step + 1)}
                  disabled={
                    (step === 1 && !isStep1Valid) ||
                    (step === 2 && !isStep2Valid) ||
                    (step === 3 && !isStep3Valid)
                  }
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#121212] hover:bg-black text-white text-xs font-medium rounded-none disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <span>Continue</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFinish}
                  disabled={!isStep4Valid || isFinishing}
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#121212] hover:bg-black text-white text-xs font-medium rounded-none disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-md"
                >
                  <Sparkles className="w-3.5 h-3.5 text-white" />
                  <span>{isFinishing ? 'Saving...' : 'Save & finish'}</span>
                </button>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
};
