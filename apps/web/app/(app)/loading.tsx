import { LoadingSpinner } from "@/modules/ui/components/loading-spinner";

// Fallback for any (app) route that does not declare a more specific loading.tsx. Rendered inside
// the authenticated shell, so the sidebar stays put and only the content area shows the spinner.
const AppLoading = () => (
  <div className="flex h-full min-h-[60vh] w-full items-center justify-center">
    <LoadingSpinner />
  </div>
);

export default AppLoading;
