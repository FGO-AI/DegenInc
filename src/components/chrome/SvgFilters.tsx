/**
 * Off-screen filter definitions referenced by `filter: url(#id)` throughout the
 * app. Rendered once in the root layout. Every one is a turbulence field driving
 * a displacement map — the difference is only in scale and frequency:
 *
 *   #rough — borders and the seal: a fine, tight wobble
 *   #grime — display headlines: a coarser chew
 *   #tear  — the memo: long low-frequency rips down one axis
 *
 * Static markup, so this stays a server component.
 */
export function SvgFilters() {
  return (
    <svg className="svgdefs" aria-hidden="true">
      <filter id="rough" x="-8%" y="-8%" width="116%" height="116%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.016 0.045"
          numOctaves="3"
          seed="11"
          result="n"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="n"
          scale="5"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>

      <filter id="grime" x="-4%" y="-6%" width="108%" height="112%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.03 0.09"
          numOctaves="2"
          seed="3"
          result="n"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="n"
          scale="3"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>

      <filter id="tear" x="-6%" y="-6%" width="112%" height="112%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.008 0.06"
          numOctaves="4"
          seed="19"
          result="n"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="n"
          scale="7"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
