import { useMutation } from "@tanstack/react-query";
import { resetRepoPermissions } from "@/api/repos";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { showToast } from "@/lib/toast";
import { t } from "@/i18n/translate";

interface ResetPermissionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoId: number;
}

export function ResetPermissionsDialog({
  open,
  onOpenChange,
  repoId,
}: ResetPermissionsDialogProps) {
  const resetPermissionsMutation = useMutation({
    mutationFn: () => resetRepoPermissions(repoId),
    onSuccess: () => {
      showToast.success(t("Permissions reset successfully"));
      onOpenChange(false);
    },
    onError: () => {
      showToast.error(t("Failed to reset permissions"));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Reset Permissions")}</DialogTitle>
          <DialogDescription>
            {t('This will clear all "Allow Always" permissions for this repository. You will be prompted again for permission when opencode needs to perform actions like running commands or editing files.')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={resetPermissionsMutation.isPending}
          >
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => resetPermissionsMutation.mutate()}
            disabled={resetPermissionsMutation.isPending}
          >
            {resetPermissionsMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("Resetting...")}
              </>
            ) : (
              t("Reset Permissions")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
