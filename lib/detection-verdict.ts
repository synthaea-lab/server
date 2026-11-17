import type { Prisma } from "@prisma/client";

/**
 * The detections an analyst judged false positives (#78). A `Detection` carries no verdict of its
 * own: the analyst marks the case it was grouped into, its host `Case` or its `FleetCase`, with
 * `status = "false_positive"`. Severity says nothing about whether a detection was wrong, so it is
 * not part of this filter.
 *
 * A verdict lags its detection: a detection not yet grouped, or grouped into a case nobody has
 * triaged, is not counted here, whatever it turns out to be.
 */
export const analystMarkedFalsePositive: Prisma.DetectionWhereInput = {
  OR: [{ case: { status: "false_positive" } }, { fleetCase: { status: "false_positive" } }],
};
