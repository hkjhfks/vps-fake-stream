import { createApp } from 'vue';
import App from './App.vue';
import router from './router';

import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/views-overview.css';
import './styles/views-settings.css';
import './styles/views-playground.css';
import './styles/views-logs.css';
import './styles/responsive.css';
import './styles/app-extras.css';
import './styles/app-extras-pages.css';

const app = createApp(App);
app.use(router);
router.isReady().then(() => app.mount('#app'));
