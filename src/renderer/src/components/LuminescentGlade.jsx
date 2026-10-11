import { useId } from 'react'

/** Original vector forest and spirit tree; shares a palette with luminous fantasy games, no game assets. */
export default function LuminescentGlade() {
  const id = useId().replaceAll(':', '')
  return (
    <svg
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className="glade-scene"
    >
      <defs>
        <radialGradient id={id + 'sky'}>
          <stop stopColor="#51eadf" />
          <stop offset=".4" stopColor="#126b81" />
          <stop offset=".75" stopColor="#242050" />
          <stop offset="1" stopColor="#070e28" />
        </radialGradient>
        <linearGradient id={id + 'bark'} x2="1" y2="0">
          <stop stopColor="#092b45" />
          <stop offset=".48" stopColor="#236677" />
          <stop offset=".68" stopColor="#a2fff2" />
          <stop offset="1" stopColor="#244a6a" />
        </linearGradient>
        <radialGradient id={id + 'leaves'}>
          <stop stopColor="#bafff5" />
          <stop offset=".3" stopColor="#43efda" />
          <stop offset=".72" stopColor="#187d9b" stopOpacity=".8" />
          <stop offset="1" stopColor="#7158d8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id + 'water'} x2="0" y2="1">
          <stop stopColor="#30adb3" />
          <stop offset="1" stopColor="#10102e" />
        </linearGradient>
        <filter id={id + 'glow'} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
      </defs>
      <path fill={'url(#' + id + 'sky)'} d="M0 0h1600v900H0z" />
      <g fill="none" stroke="#132c49" strokeWidth="25" opacity=".6">
        <path d="M220 700Q280 350 160 0M290 300L390 80M1350 710Q1290 380 1430 0M1310 370L1180 110M480 650L450 0M1110 680L1170 0" />
      </g>
      <g fill={'url(#' + id + 'leaves)'} opacity=".75">
        <ellipse cx="620" cy="240" rx="340" ry="210" />
        <ellipse cx="990" cy="230" rx="340" ry="200" />
        <ellipse cx="800" cy="135" rx="290" ry="180" />
      </g>
      <path d="M0 740Q260 630 580 707Q800 750 1040 680Q1390 620 1600 718V900H0Z" fill="#071e30" />
      <path
        d="M770 696Q890 750 710 799Q600 836 918 900H1270Q842 810 950 770Q1000 720 895 695Z"
        fill={'url(#' + id + 'water)'}
      />
      <path
        d="M598 728Q797 646 745 452Q713 378 593 341L470 222L627 307L694 306L603 164L744 298L787 396L828 248L805 93L865 225L898 274L1034 143L946 310L1118 269L1240 177L1154 313L970 370Q866 435 868 533Q875 646 1030 716L876 681L812 726L757 675Z"
        fill={'url(#' + id + 'bark)'}
      />
      <g fill="none" stroke="#8dfff2" strokeLinecap="round">
        <path
          d="M821 663Q768 558 813 440Q874 335 853 224M820 437Q749 326 653 306M861 360L978 329"
          strokeWidth="8"
          opacity=".7"
          filter={'url(#' + id + 'glow)'}
        />
        <path d="M821 663Q768 558 813 440Q874 335 853 224" strokeWidth="2" />
      </g>
      <g fill="#a6ffee" className="glade-lights">
        {Array.from({ length: 32 }, (_, i) => (
          <circle
            key={i}
            cx={350 + ((i * 137) % 940)}
            cy={90 + ((i * 97) % 610)}
            r={(i % 3) + 1.5}
            style={{ animationDelay: `${-i * 0.7}s` }}
          />
        ))}
      </g>
      <g fill="#071221">
        <path d="M0 0H118Q180 245 128 471Q123 640 272 900H0ZM1600 0H1500Q1430 320 1497 535L1353 900H1600Z" />
        <path d="M85 265L420 15L280 212L120 389M1520 180L1250 0L1380 200L1510 304" />
      </g>
      <g fill="#42bcbc" opacity=".8">
        <path d="M204 816l-46-125 73 111-6-90 35 111ZM1265 794l-31-90 56 88 24-130 8 131Z" />
      </g>
      <g fill="#9e63f0">
        <ellipse cx="260" cy="784" rx="34" ry="10" />
        <ellipse cx="1292" cy="757" rx="30" ry="9" />
      </g>
      <path d="M0 853Q400 742 640 889Q1230 782 1600 842V900H0Z" fill="#060e20" />
    </svg>
  )
}
