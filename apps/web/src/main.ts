import { createApp } from "vue";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import "./styles.css";
import App from "./App.vue";
import { router } from "./router";

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: "applicationChecker",
    themes: {
      applicationChecker: {
        dark: false,
        colors: {
          primary: "#183a37",
          secondary: "#c97843",
          background: "#f5f2ea",
          surface: "#fffdf8",
        },
      },
    },
  },
});

createApp(App).use(vuetify).use(router).mount("#app");
