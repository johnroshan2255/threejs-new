import { serveWorker } from "./workerClient";
import {
	buildPunchHolesData,
	type PunchHolesRequest,
	type PunchHolesResult,
} from "../terrain/punchHolesCore";

serveWorker<PunchHolesRequest, PunchHolesResult | null>((payload) => {
	const result = buildPunchHolesData(payload);
	if (!result) return { result: null };
	return {
		result,
		transfer: [result.newIndex.buffer],
	};
});
