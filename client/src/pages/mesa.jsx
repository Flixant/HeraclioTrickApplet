import Mesa1v1 from "./mesa1v1";
import Mesa2v2 from "./mesa2v2";

function Mesa(props) {
  const mode = props?.gameState?.mode;
  if (mode === "2vs2") {
    return <Mesa2v2 {...props} />;
  }
  return <Mesa1v1 {...props} />;
}

export default Mesa;
