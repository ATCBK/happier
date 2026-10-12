// The machine page lives in the Machines doors (`/machines/<id>`, `/settings/machines/<id>`); this 0.2-era
// route only leads there.
import { MachineLegacyRouteRedirect } from '@/components/machines/page/MachineLegacyRouteRedirect';

export default function MachineLegacyRoute() {
    return <MachineLegacyRouteRedirect />;
}
