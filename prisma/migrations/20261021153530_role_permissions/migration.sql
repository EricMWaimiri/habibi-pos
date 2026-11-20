-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "receivedShiftId" TEXT;

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "permission" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_permissions_role_idx" ON "role_permissions"("role");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_permission_key" ON "role_permissions"("role", "permission");

-- CreateIndex
CREATE INDEX "payments_receivedShiftId_idx" ON "payments"("receivedShiftId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_receivedShiftId_fkey" FOREIGN KEY ("receivedShiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
