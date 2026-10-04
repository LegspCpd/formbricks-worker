import { Metadata } from "next";
import { Inter } from "next/font/google";
import React from "react";
import { NoScriptWarning } from "@/app/components/NoScriptWarning";
import { DEFAULT_LOCALE } from "@/lib/constants";
import { SentryClientConfigScript } from "@/lib/sentry/SentryClientConfigScript";
import { I18nProvider } from "@/lingodotdev/client";
import { getLocale } from "@/lingodotdev/language";
import { NavigationProgress } from "@/modules/ui/components/navigation-progress";
import { StaleDeploymentPrompt } from "@/modules/ui/components/stale-deployment-prompt";
import "../modules/ui/globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    template: "%s | Formbricks",
    default: "Formbricks",
  },
  description: "Open-Source Survey Suite",
};

const RootLayout = async ({ children }: { children: React.ReactNode }) => {
  const locale = await getLocale();

  return (
    <html lang={locale} translate="no" className={inter.variable}>
      <body className="flex h-dvh flex-col font-sans antialiased transition-all ease-in-out">
        {/* First in the document so instrumentation-client.ts can start Sentry as early as possible. */}
        <SentryClientConfigScript />
        <NavigationProgress />
        <NoScriptWarning locale={locale} />
        <I18nProvider language={locale} defaultLanguage={DEFAULT_LOCALE}>
          <StaleDeploymentPrompt />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
};

export default RootLayout;
